import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1, sha256 } from '../../hash'
import type { IntradayMarketSnapshot, IntradaySnapshotRequest } from './model'
import type { IntradayBarRow, IntradayQuoteRow, IntradayTradeRow } from './rows'
import { reverifyIntradayMarketSnapshot, verifyIntradaySnapshot, verifyIntradaySnapshotRequest } from './verification'

const symbols = ['AMD', 'NVDA'] as const
const barsTopic = 'torghut.bars.1m.v1'
const quotesTopic = 'torghut.quotes.v1'
const tradesTopic = 'torghut.trades.v1'

const request: IntradaySnapshotRequest = {
  sessionDate: '2026-08-18',
  rangeStartAt: '2026-08-18T13:30:00.000Z',
  rangeEndAt: '2026-08-18T13:35:00.000Z',
  observedAt: '2026-08-18T13:35:30.000Z',
  universeId: 'torghut-core-equity-v1',
  universeSymbolHash: sha256(symbols.join(',')),
  universe: symbols,
  feed: 'sip',
  delayClass: 'real_time_consolidated',
  sourceTopics: { bars: barsTopic, quotes: quotesTopic, trades: tradesTopic },
  maximumQuoteAgeMs: 60_000,
  minimumWatermarkLagMs: 30_000,
  archiveWatermarks: [
    { sourceTopic: barsTopic, sourcePartition: 0, inclusiveLastOffset: '10' },
    { sourceTopic: quotesTopic, sourcePartition: 0, inclusiveLastOffset: '12' },
    { sourceTopic: tradesTopic, sourcePartition: 0, inclusiveLastOffset: '14' },
  ],
}

type IntradayIdentityRow = Omit<IntradayQuoteRow, 'bid_price' | 'bid_size' | 'ask_price' | 'ask_size'>

const identity = (symbol: string, eventAt: string, sourceTopic: string, sourceOffset: number): IntradayIdentityRow => ({
  provider: 'alpaca',
  universe_id: request.universeId,
  universe_symbol_hash: request.universeSymbolHash,
  feed: request.feed,
  market_session: 'regular',
  delay_class: request.delayClass,
  symbol,
  event_at: eventAt,
  ingested_at: eventAt,
  source_topic: sourceTopic,
  source_partition: '0',
  source_offset: String(sourceOffset),
  schema_version: '1',
})

const makeRows = () => {
  let offset = 1
  const bars: IntradayBarRow[] = symbols.flatMap((symbol) =>
    Array.from({ length: 5 }, (_, minute) => {
      const eventAt = `2026-08-18T13:3${minute}:00.000Z`
      const ingestedAt = `2026-08-18T13:3${minute + 1}:00.000Z`
      return {
        ...identity(symbol, eventAt, barsTopic, offset++),
        ingested_at: ingestedAt,
        channel: 'bars',
        is_final: '1',
        open: '100',
        high: '102',
        low: '99',
        close: String(100 + minute / 10),
        volume: '1000',
        vwap: '100.5',
        trade_count: '100',
      }
    }),
  )
  const quotes: IntradayQuoteRow[] = symbols.map((symbol) => ({
    ...identity(symbol, '2026-08-18T13:35:15.000Z', quotesTopic, offset++),
    bid_price: '100',
    bid_size: '10',
    ask_price: '100.02',
    ask_size: '12',
  }))
  const trades: IntradayTradeRow[] = symbols.map((symbol) => ({
    ...identity(symbol, '2026-08-18T13:34:58.000Z', tradesTopic, offset++),
    price: '100.01',
    size: '5',
  }))
  const archiveWatermarks = request.archiveWatermarks.map((watermark) => ({
    source_topic: watermark.sourceTopic,
    source_partition: String(watermark.sourcePartition),
    inclusive_last_offset: watermark.inclusiveLastOffset,
  }))
  return { archiveWatermarks, bars, quotes, trades }
}

const success = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result)
const error = <A, E>(result: Result.Result<A, E>): E => Result.getOrThrow(Result.flip(result))

describe('immutable intraday market snapshot', () => {
  test('binds a complete opening range, fresh quotes, trades, and Kafka lineage deterministically', () => {
    const rows = makeRows()
    const snapshot = success(verifyIntradaySnapshot(request, rows))
    const reordered = success(
      verifyIntradaySnapshot(request, {
        archiveWatermarks: rows.archiveWatermarks,
        bars: rows.bars.toReversed(),
        quotes: rows.quotes.toReversed(),
        trades: rows.trades.toReversed(),
      }),
    )

    expect(snapshot.manifest).toMatchObject({
      schemaVersion: 'bayn.intraday-market-snapshot.v1',
      barCount: 10,
      quoteCount: 2,
      tradeCount: 2,
      sourceTopics: request.sourceTopics,
    })
    expect(snapshot.latestQuotes['NVDA']?.askPrice).toBe(100.02)
    expect(snapshot.manifest.lineage).toHaveLength(3)
    expect(reordered.manifest.snapshotId).toBe(snapshot.manifest.snapshotId)
    expect(reordered.manifest.contentHash).toBe(snapshot.manifest.contentHash)
  })

  test('publishes detached immutable archive watermarks', () => {
    const rows = makeRows()
    const mutableWatermarks = request.archiveWatermarks.map((watermark) => ({ ...watermark }))
    const mutableRequest: IntradaySnapshotRequest = { ...request, archiveWatermarks: mutableWatermarks }
    const snapshot = success(verifyIntradaySnapshot(mutableRequest, rows))
    const originalManifest = snapshot.manifest

    mutableWatermarks[0]!.inclusiveLastOffset = '999'

    expect(snapshot.manifest).toEqual(originalManifest)
    expect(snapshot.manifest.archiveWatermarks[0]?.inclusiveLastOffset).toBe('10')
    expect(Object.isFrozen(snapshot.manifest.archiveWatermarks)).toBe(true)
    expect(Object.isFrozen(snapshot.manifest.archiveWatermarks[0])).toBe(true)
  })

  test('uses ClickHouse binary ordering for case-mixed Kafka topics', () => {
    const caseMixedRequest: IntradaySnapshotRequest = {
      ...request,
      sourceTopics: { bars: 'alpha', quotes: 'Alpha', trades: 'zeta' },
      archiveWatermarks: [
        { sourceTopic: 'Alpha', sourcePartition: 0, inclusiveLastOffset: '12' },
        { sourceTopic: 'alpha', sourcePartition: 0, inclusiveLastOffset: '10' },
        { sourceTopic: 'zeta', sourcePartition: 0, inclusiveLastOffset: '14' },
      ],
    }

    expect(success(verifyIntradaySnapshotRequest(caseMixedRequest))).toEqual(caseMixedRequest)
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...caseMixedRequest,
          archiveWatermarks: caseMixedRequest.archiveWatermarks.toReversed(),
        }),
      ),
    ).toMatchObject({ reason: 'watermark' })
  })

  test('reruns row-level invariants instead of trusting a self-rehashed payload', () => {
    const verified = success(verifyIntradaySnapshot(request, makeRows()))
    expect(success(reverifyIntradayMarketSnapshot(verified))).toEqual(verified)

    const firstBar = verified.bars[0]
    if (firstBar === undefined) throw new Error('bar fixture is incomplete')
    const bars = Object.freeze([firstBar, firstBar, ...verified.bars.slice(2)])
    const { contentHash: _contentHash, snapshotId: _snapshotId, ...boundMaterial } = verified.manifest
    const material = Object.freeze({ ...boundMaterial, barsContentHash: canonicalHashV1(bars) })
    const contentHash = canonicalHashV1(material)
    const manifest = Object.freeze({
      ...material,
      contentHash,
      snapshotId: canonicalHashV1({ ...material, contentHash }),
    })
    const selfRehashed: IntradayMarketSnapshot = Object.freeze({ ...verified, bars, manifest })

    expect(error(reverifyIntradayMarketSnapshot(selfRehashed))).toMatchObject({ reason: 'coverage' })
  })

  test('rejects altered manifest metadata even when rows and snapshot identity are unchanged', () => {
    const verified = success(verifyIntradaySnapshot(request, makeRows()))
    const forgedManifest = Object.freeze({
      ...verified.manifest,
      barCount: verified.manifest.barCount + 1,
    })
    const forged: IntradayMarketSnapshot = Object.freeze({ ...verified, manifest: forgedManifest })

    expect(error(reverifyIntradayMarketSnapshot(forged))).toMatchObject({ reason: 'hash' })
  })

  test('fails closed when the one-minute grid is incomplete', () => {
    const rows = makeRows()
    const failure = error(verifyIntradaySnapshot(request, { ...rows, bars: rows.bars.slice(1) }))
    expect(failure).toMatchObject({ _tag: 'IntradaySnapshotFailure', reason: 'coverage' })
  })

  test('rejects non-aligned requests and non-canonical numeric rows', () => {
    const rows = makeRows()
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          sessionDate: '2026-08-1',
        }),
      ),
    ).toMatchObject({ reason: 'request' })
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          archiveWatermarks: request.archiveWatermarks.map((watermark, index) =>
            index === 0 ? { ...watermark, sourcePartition: 2_147_483_648 } : watermark,
          ),
        }),
      ),
    ).toMatchObject({ reason: 'watermark' })
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          archiveWatermarks: request.archiveWatermarks.map((watermark, index) =>
            index === 0 ? { ...watermark, inclusiveLastOffset: '9223372036854775808' } : watermark,
          ),
        }),
      ),
    ).toMatchObject({ reason: 'watermark' })
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          archiveWatermarks: request.archiveWatermarks.map((watermark, index) =>
            index === 0 ? { ...watermark, inclusiveLastOffset: '18446744073709551616' } : watermark,
          ),
        }),
      ),
    ).toMatchObject({ reason: 'watermark' })
    expect(
      error(
        verifyIntradaySnapshot(
          {
            ...request,
            rangeStartAt: '2026-08-18T13:30:00.500Z',
            rangeEndAt: '2026-08-18T13:35:00.500Z',
          },
          rows,
        ),
      ),
    ).toMatchObject({ reason: 'request' })
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          observedAt: '2026-08-18T13:55:00.001Z',
        }),
      ),
    ).toMatchObject({ reason: 'request' })

    const firstQuote = rows.quotes[0]
    if (firstQuote === undefined) throw new Error('quote fixture is incomplete')
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: [{ ...firstQuote, source_partition: '2147483648' }, ...rows.quotes.slice(1)],
        }),
      ),
    ).toMatchObject({ reason: 'lineage' })
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: [{ ...firstQuote, bid_size: ' ' }, ...rows.quotes.slice(1)],
        }),
      ),
    ).toMatchObject({ reason: 'rows' })
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: [{ ...firstQuote, source_offset: '011' }, ...rows.quotes.slice(1)],
        }),
      ),
    ).toMatchObject({ reason: 'lineage' })

    const firstBar = rows.bars[0]
    if (firstBar === undefined) throw new Error('bar fixture is incomplete')
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          bars: [{ ...firstBar, vwap: '103' }, ...rows.bars.slice(1)],
        }),
      ),
    ).toMatchObject({ reason: 'rows' })
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          bars: [{ ...firstBar, trade_count: '01' }, ...rows.bars.slice(1)],
        }),
      ),
    ).toMatchObject({ reason: 'rows' })
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          bars: [{ ...firstBar, trade_count: '18446744073709551616' }, ...rows.bars.slice(1)],
        }),
      ),
    ).toMatchObject({ reason: 'rows' })
  })

  test('detaches and freezes a verified request before asynchronous use', () => {
    const mutableUniverse = [...request.universe]
    const mutableTopics = { ...request.sourceTopics }
    const mutableWatermarks = request.archiveWatermarks.map((watermark) => ({ ...watermark }))
    const mutableRequest: IntradaySnapshotRequest = {
      ...request,
      universe: mutableUniverse,
      sourceTopics: mutableTopics,
      archiveWatermarks: mutableWatermarks,
    }
    const verified = success(verifyIntradaySnapshotRequest(mutableRequest))

    mutableUniverse[0] = 'AAPL'
    mutableTopics.quotes = 'changed.quotes'
    mutableWatermarks[0]!.inclusiveLastOffset = '999'

    expect(verified.universe).toEqual(request.universe)
    expect(verified.sourceTopics).toEqual(request.sourceTopics)
    expect(verified.archiveWatermarks).toEqual(request.archiveWatermarks)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.universe)).toBe(true)
    expect(Object.isFrozen(verified.sourceTopics)).toBe(true)
    expect(Object.isFrozen(verified.archiveWatermarks)).toBe(true)
    expect(Object.isFrozen(verified.archiveWatermarks[0])).toBe(true)
  })

  test('preserves canonical nanosecond ordering timestamps from quote/trade archive rows', () => {
    const rows = makeRows()
    const quotes = rows.quotes.map((quote) => ({
      ...quote,
      event_at: '2026-08-18T13:35:15.123456789Z',
      ingested_at: '2026-08-18T13:35:15.223456789Z',
    }))
    const trades = rows.trades.map((trade) => ({
      ...trade,
      event_at: '2026-08-18T13:34:58.123456789Z',
      ingested_at: '2026-08-18T13:34:58.223456789Z',
    }))

    const snapshot = success(verifyIntradaySnapshot(request, { ...rows, quotes, trades }))
    expect(snapshot.quotes[0]?.eventAt).toBe('2026-08-18T13:35:15.123456789Z')
    expect(snapshot.trades[0]?.eventAt).toBe('2026-08-18T13:34:58.123456789Z')
  })

  test('enforces causal and observation ordering at nanosecond precision', () => {
    const rows = makeRows()
    const firstQuote = rows.quotes[0]
    if (firstQuote === undefined) throw new Error('quote fixture is incomplete')

    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: [
            {
              ...firstQuote,
              event_at: '2026-08-18T13:35:15.123456789Z',
              ingested_at: '2026-08-18T13:35:15.123456788Z',
            },
            ...rows.quotes.slice(1),
          ],
        }),
      ),
    ).toMatchObject({ reason: 'ordering' })

    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: [
            {
              ...firstQuote,
              event_at: '2026-08-18T13:35:30.000000001Z',
              ingested_at: '2026-08-18T13:35:30.000000001Z',
            },
            ...rows.quotes.slice(1),
          ],
        }),
      ),
    ).toMatchObject({ reason: 'ordering' })
  })

  test('fails closed on stale quotes and missing trades', () => {
    const rows = makeRows()
    const staleQuotes = rows.quotes.map((quote) => ({ ...quote, event_at: '2026-08-18T13:33:00.000Z' }))
    expect(error(verifyIntradaySnapshot(request, { ...rows, quotes: staleQuotes }))).toMatchObject({
      reason: 'freshness',
    })
    expect(error(verifyIntradaySnapshot(request, { ...rows, trades: rows.trades.slice(1) }))).toMatchObject({
      reason: 'coverage',
    })
  })

  test('fails closed on source-topic drift and duplicate Kafka identity', () => {
    const rows = makeRows()
    const firstQuote = rows.quotes[0]
    const secondQuote = rows.quotes[1]
    if (firstQuote === undefined || secondQuote === undefined) throw new Error('quote fixture is incomplete')

    const wrongTopic = [{ ...firstQuote, source_topic: barsTopic }, ...rows.quotes.slice(1)]
    expect(error(verifyIntradaySnapshot(request, { ...rows, quotes: wrongTopic }))).toMatchObject({
      reason: 'identity',
    })

    const duplicateLineage = [firstQuote, { ...secondQuote, source_offset: firstQuote.source_offset }]
    expect(error(verifyIntradaySnapshot(request, { ...rows, quotes: duplicateLineage }))).toMatchObject({
      reason: 'lineage',
    })
  })

  test('binds a materialized archive version and rejects non-final or post-version records', () => {
    const rows = makeRows()
    const finalBar = rows.bars.at(-1)
    const finalQuote = rows.quotes.at(-1)
    if (finalBar === undefined || finalQuote === undefined) throw new Error('archive fixture is incomplete')

    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          bars: [...rows.bars.slice(0, -1), { ...finalBar, is_final: '0' }],
        }),
      ),
    ).toMatchObject({ reason: 'freshness' })
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          archiveWatermarks: rows.archiveWatermarks.map((watermark) =>
            watermark.source_topic === quotesTopic ? { ...watermark, inclusive_last_offset: '11' } : watermark,
          ),
        }),
      ),
    ).toMatchObject({ reason: 'watermark' })
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: [...rows.quotes.slice(0, -1), { ...finalQuote, source_offset: '13' }],
          archiveWatermarks: rows.archiveWatermarks.map((watermark) =>
            watermark.source_topic === quotesTopic ? { ...watermark, inclusive_last_offset: '13' } : watermark,
          ),
        }),
      ),
    ).toMatchObject({ reason: 'ordering' })

    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: [...rows.quotes.slice(0, -1), { ...finalQuote, source_partition: '1' }],
        }),
      ),
    ).toMatchObject({ reason: 'ordering' })
  })

  test('rejects evidence that violates its declared real-time feed delay', () => {
    const rows = makeRows()
    const firstQuote = rows.quotes[0]
    if (firstQuote === undefined) throw new Error('quote fixture is incomplete')
    const lateObservationRequest = { ...request, observedAt: '2026-08-18T13:50:00.000Z' }

    expect(
      error(
        verifyIntradaySnapshot(lateObservationRequest, {
          ...rows,
          quotes: [
            { ...firstQuote, event_at: request.rangeEndAt, ingested_at: '2026-08-18T13:49:45.000Z' },
            ...rows.quotes.slice(1),
          ],
        }),
      ),
    ).toMatchObject({ reason: 'freshness', message: 'intraday evidence does not match its declared feed delay' })
  })

  test('rejects mixed-session observations and verifies delayed-feed availability', () => {
    const rows = makeRows()
    expect(error(verifyIntradaySnapshot({ ...request, observedAt: '2026-08-19T13:35:30.000Z' }, rows))).toMatchObject({
      reason: 'request',
    })

    const delayedRequest: IntradaySnapshotRequest = {
      ...request,
      observedAt: '2026-08-18T13:50:30.000Z',
      feed: 'delayed_sip',
      delayClass: 'delayed_15m_consolidated',
    }
    const delayedIdentity = <T extends IntradayBarRow | IntradayQuoteRow | IntradayTradeRow>(row: T): T => ({
      ...row,
      feed: delayedRequest.feed,
      delay_class: delayedRequest.delayClass,
    })
    const delayedRows = {
      archiveWatermarks: rows.archiveWatermarks,
      bars: rows.bars.map(delayedIdentity),
      quotes: rows.quotes.map((quote) => ({
        ...delayedIdentity(quote),
        ingested_at: '2026-08-18T13:50:15.000Z',
      })),
      trades: rows.trades.map((trade) => ({
        ...delayedIdentity(trade),
        ingested_at: '2026-08-18T13:50:00.000Z',
      })),
    }

    expect(success(verifyIntradaySnapshot(delayedRequest, delayedRows)).manifest.delayClass).toBe(
      'delayed_15m_consolidated',
    )
    expect(
      error(
        verifyIntradaySnapshot(delayedRequest, {
          ...delayedRows,
          quotes: delayedRows.quotes.map((quote) => ({ ...quote, ingested_at: quote.event_at })),
        }),
      ),
    ).toMatchObject({ reason: 'freshness' })
  })
})
