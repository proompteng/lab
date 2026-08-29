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
const calendarMaterial = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
  source: 'alpaca-v2-calendar' as const,
  requestedRange: { start: '2026-08-18', end: '2026-08-18' },
  timeZone: 'UTC' as const,
  sessions: [{ date: '2026-08-18', openAt: '2026-08-18T13:30:00.000Z', closeAt: '2026-08-18T20:00:00.000Z' }],
}
const calendar = { ...calendarMaterial, normalizedResponseHash: canonicalHashV1(calendarMaterial) }

const request: IntradaySnapshotRequest = {
  sessionDate: '2026-08-18',
  calendar,
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

type IntradayIdentityRow = Omit<
  IntradayQuoteRow,
  'latest_payload_variants' | 'bid_price' | 'bid_size' | 'ask_price' | 'ask_size'
>

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
    latest_payload_variants: '1',
    bid_price: '100',
    bid_size: '10',
    ask_price: '100.02',
    ask_size: '12',
  }))
  const trades: IntradayTradeRow[] = symbols.map((symbol) => ({
    ...identity(symbol, '2026-08-18T13:35:10.000Z', tradesTopic, offset++),
    latest_payload_variants: '1',
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

  test('binds complete post-range evidence without requiring every symbol to be selection-fresh simultaneously', () => {
    const snapshot = success(verifyIntradaySnapshot({ ...request, observedAt: '2026-08-18T13:36:30.000Z' }, makeRows()))

    expect(snapshot.manifest).toMatchObject({
      observedAt: '2026-08-18T13:36:30.000Z',
      quoteCount: symbols.length,
      tradeCount: symbols.length,
    })
    expect(success(reverifyIntradayMarketSnapshot(snapshot))).toEqual(snapshot)
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

  test('reruns exchange-session invariants instead of trusting a self-rehashed calendar', () => {
    const verified = success(verifyIntradaySnapshot(request, makeRows()))
    const forgedCalendarMaterial = {
      schemaVersion: verified.manifest.calendar.schemaVersion,
      source: verified.manifest.calendar.source,
      requestedRange: { ...verified.manifest.calendar.requestedRange },
      timeZone: verified.manifest.calendar.timeZone,
      sessions: verified.manifest.calendar.sessions.map((session) => ({
        ...session,
        openAt: '2026-08-18T14:30:00.000Z',
      })),
    }
    const forgedCalendar = Object.freeze({
      ...forgedCalendarMaterial,
      normalizedResponseHash: canonicalHashV1(forgedCalendarMaterial),
    })
    const { contentHash: _contentHash, snapshotId: _snapshotId, ...boundMaterial } = verified.manifest
    const material = Object.freeze({ ...boundMaterial, calendar: forgedCalendar })
    const contentHash = canonicalHashV1(material)
    const manifest = Object.freeze({
      ...material,
      contentHash,
      snapshotId: canonicalHashV1({ ...material, contentHash }),
    })
    const selfRehashed: IntradayMarketSnapshot = Object.freeze({ ...verified, manifest })

    expect(error(reverifyIntradayMarketSnapshot(selfRehashed))).toMatchObject({ reason: 'request' })
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

  test('accepts sparse trade-aggregated bars while rejecting duplicate or misaligned minutes', () => {
    const rows = makeRows()
    const sparse = success(verifyIntradaySnapshot(request, { ...rows, bars: rows.bars.slice(1) }))

    expect(sparse.manifest.barCount).toBe(9)
    expect(success(reverifyIntradayMarketSnapshot(sparse))).toEqual(sparse)

    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          bars: rows.bars.filter((bar) => !(bar.symbol === 'AMD' && bar.event_at === '2026-08-18T13:34:00.000Z')),
        }),
      ),
    ).toMatchObject({
      _tag: 'IntradaySnapshotFailure',
      reason: 'not-ready',
      message: 'intraday snapshot lacks a per-symbol range-completion bar',
      facts: {
        symbol: 'AMD',
        eventAt: '2026-08-18T13:34:00.000Z',
      },
    })

    const firstSparseBar = rows.bars[1]
    if (firstSparseBar === undefined) throw new Error('sparse bar fixture is incomplete')
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          bars: [
            ...rows.bars.slice(1),
            {
              ...firstSparseBar,
              event_at: firstSparseBar.event_at.replace('.000Z', '.000000000Z'),
              ingested_at: firstSparseBar.ingested_at.replace('.000Z', '.000000000Z'),
            },
          ],
        }),
      ),
    ).toMatchObject({
      _tag: 'IntradaySnapshotFailure',
      reason: 'coverage',
      message: 'intraday snapshot duplicates a one-minute bar',
    })

    const firstBar = rows.bars[0]
    if (firstBar === undefined) throw new Error('bar fixture is incomplete')
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          bars: [
            {
              ...firstBar,
              event_at: '2026-08-18T13:30:00.000000001Z',
              ingested_at: '2026-08-18T13:31:00.000000001Z',
            },
            ...rows.bars.slice(1),
          ],
        }),
      ),
    ).toMatchObject({
      _tag: 'IntradaySnapshotFailure',
      reason: 'coverage',
      message: 'intraday bar is not aligned to the requested one-minute grid',
    })
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

  test('binds the range to one finalized regular exchange session', () => {
    const premarketMaterial = {
      ...calendarMaterial,
      sessions: [
        {
          date: '2026-08-18',
          openAt: '2026-08-18T13:30:00.000Z',
          closeAt: '2026-08-18T20:00:00.000Z',
        },
      ],
    }
    const premarketCalendar = {
      ...premarketMaterial,
      normalizedResponseHash: canonicalHashV1(premarketMaterial),
    }
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          calendar: premarketCalendar,
          rangeStartAt: '2026-08-18T13:00:00.000Z',
          rangeEndAt: '2026-08-18T13:05:00.000Z',
          observedAt: '2026-08-18T13:05:30.000Z',
        }),
      ),
    ).toMatchObject({ reason: 'request' })

    const weekendMaterial = {
      ...calendarMaterial,
      requestedRange: { start: '2026-08-22', end: '2026-08-22' },
      sessions: [
        {
          date: '2026-08-22',
          openAt: '2026-08-22T13:30:00.000Z',
          closeAt: '2026-08-22T20:00:00.000Z',
        },
      ],
    }
    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          sessionDate: '2026-08-22',
          calendar: { ...weekendMaterial, normalizedResponseHash: canonicalHashV1(weekendMaterial) },
          rangeStartAt: '2026-08-22T13:30:00.000Z',
          rangeEndAt: '2026-08-22T13:35:00.000Z',
          observedAt: '2026-08-22T13:35:30.000Z',
        }),
      ),
    ).toMatchObject({ reason: 'request' })

    const earlyCloseMaterial = {
      ...calendarMaterial,
      sessions: [
        {
          date: '2026-08-18',
          openAt: '2026-08-18T13:30:00.000Z',
          closeAt: '2026-08-18T18:00:00.000Z',
        },
      ],
    }
    expect(
      verifyIntradaySnapshotRequest({
        ...request,
        calendar: { ...earlyCloseMaterial, normalizedResponseHash: canonicalHashV1(earlyCloseMaterial) },
        rangeStartAt: '2026-08-18T17:55:00.000Z',
        rangeEndAt: '2026-08-18T18:00:00.000Z',
        observedAt: '2026-08-18T18:15:00.000Z',
        feed: 'delayed_sip',
        delayClass: 'delayed_15m_consolidated',
      }),
    ).toMatchObject({ _tag: 'Success' })

    expect(
      error(
        verifyIntradaySnapshotRequest({
          ...request,
          calendar: { ...calendar, normalizedResponseHash: '0'.repeat(64) },
        }),
      ),
    ).toMatchObject({ reason: 'request' })
  })

  test('detaches and freezes a verified request before asynchronous use', () => {
    const mutableCalendar = {
      ...request.calendar,
      requestedRange: { ...request.calendar.requestedRange },
      sessions: request.calendar.sessions.map((session) => ({ ...session })),
    }
    const mutableUniverse = [...request.universe]
    const mutableTopics = { ...request.sourceTopics }
    const mutableWatermarks = request.archiveWatermarks.map((watermark) => ({ ...watermark }))
    const mutableRequest: IntradaySnapshotRequest = {
      ...request,
      calendar: mutableCalendar,
      universe: mutableUniverse,
      sourceTopics: mutableTopics,
      archiveWatermarks: mutableWatermarks,
    }
    const verified = success(verifyIntradaySnapshotRequest(mutableRequest))

    mutableUniverse[0] = 'AAPL'
    mutableCalendar.sessions[0]!.openAt = '2026-08-18T14:30:00.000Z'
    mutableTopics.quotes = 'changed.quotes'
    mutableWatermarks[0]!.inclusiveLastOffset = '999'

    expect(verified.universe).toEqual(request.universe)
    expect(verified.calendar).toEqual(request.calendar)
    expect(verified.sourceTopics).toEqual(request.sourceTopics)
    expect(verified.archiveWatermarks).toEqual(request.archiveWatermarks)
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.universe)).toBe(true)
    expect(Object.isFrozen(verified.calendar)).toBe(true)
    expect(Object.isFrozen(verified.calendar.requestedRange)).toBe(true)
    expect(Object.isFrozen(verified.calendar.sessions)).toBe(true)
    expect(Object.isFrozen(verified.calendar.sessions[0])).toBe(true)
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
      event_at: '2026-08-18T13:35:10.123456789Z',
      ingested_at: '2026-08-18T13:35:10.223456789Z',
    }))

    const snapshot = success(verifyIntradaySnapshot(request, { ...rows, quotes, trades }))
    expect(snapshot.quotes[0]?.eventAt).toBe('2026-08-18T13:35:15.123456789Z')
    expect(snapshot.trades[0]?.eventAt).toBe('2026-08-18T13:35:10.123456789Z')
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

  test('fails closed on pre-range quotes and missing or pre-range trades', () => {
    const rows = makeRows()
    const staleQuotes = rows.quotes.map((quote) => ({ ...quote, event_at: '2026-08-18T13:33:00.000Z' }))
    expect(error(verifyIntradaySnapshot(request, { ...rows, quotes: staleQuotes }))).toMatchObject({
      reason: 'not-ready',
    })
    expect(error(verifyIntradaySnapshot(request, { ...rows, trades: rows.trades.slice(1) }))).toMatchObject({
      reason: 'not-ready',
    })
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          trades: rows.trades.map((trade) => ({ ...trade, event_at: '2026-08-18T13:34:59.999Z' })),
        }),
      ),
    ).toMatchObject({
      reason: 'not-ready',
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

  test('fails closed when tied latest archive records contain conflicting market payloads', () => {
    const rows = makeRows()
    expect(
      error(
        verifyIntradaySnapshot(request, {
          ...rows,
          quotes: rows.quotes.map((quote, index) => (index === 0 ? { ...quote, latest_payload_variants: '2' } : quote)),
        }),
      ),
    ).toMatchObject({
      reason: 'ordering',
      message: 'latest intraday timestamp has conflicting market payloads',
    })
  })

  test('recomputes tied payload variants instead of trusting a self-consistent forged snapshot', () => {
    const rows = makeRows()
    const firstQuote = rows.quotes[0]
    if (firstQuote === undefined) throw new Error('quote fixture is incomplete')
    const forgedRequest: IntradaySnapshotRequest = {
      ...request,
      archiveWatermarks: request.archiveWatermarks.map((watermark) =>
        watermark.sourceTopic === quotesTopic ? { ...watermark, inclusiveLastOffset: '15' } : watermark,
      ),
    }
    const forgedRows = {
      ...rows,
      archiveWatermarks: rows.archiveWatermarks.map((watermark) =>
        watermark.source_topic === quotesTopic ? { ...watermark, inclusive_last_offset: '15' } : watermark,
      ),
      quotes: [
        ...rows.quotes,
        {
          ...firstQuote,
          source_offset: '15',
          latest_payload_variants: '1',
          bid_price: '99.50',
          ask_price: '99.52',
        },
      ],
    }
    const forged = success(verifyIntradaySnapshot(forgedRequest, forgedRows))

    expect(error(reverifyIntradayMarketSnapshot(forged))).toMatchObject({
      reason: 'ordering',
      message: 'latest intraday timestamp has conflicting market payloads',
    })
  })

  test('groups tied payload variants by canonical instant across fractional precision', () => {
    const rows = makeRows()
    const firstQuote = rows.quotes[0]
    if (firstQuote === undefined) throw new Error('quote fixture is incomplete')
    const forgedRequest: IntradaySnapshotRequest = {
      ...request,
      archiveWatermarks: request.archiveWatermarks.map((watermark) =>
        watermark.sourceTopic === quotesTopic ? { ...watermark, inclusiveLastOffset: '15' } : watermark,
      ),
    }
    const forgedRows = {
      ...rows,
      archiveWatermarks: rows.archiveWatermarks.map((watermark) =>
        watermark.source_topic === quotesTopic ? { ...watermark, inclusive_last_offset: '15' } : watermark,
      ),
      quotes: [
        ...rows.quotes,
        {
          ...firstQuote,
          event_at: '2026-08-18T13:35:15.000000000Z',
          source_offset: '15',
          bid_price: '99.50',
          ask_price: '99.52',
        },
      ],
    }
    const forged = success(verifyIntradaySnapshot(forgedRequest, forgedRows))

    expect(error(reverifyIntradayMarketSnapshot(forged))).toMatchObject({
      reason: 'ordering',
      message: 'latest intraday timestamp has conflicting market payloads',
    })
  })

  test('returns a typed row failure for malformed replayed quote and trade timestamps', () => {
    const verified = success(verifyIntradaySnapshot(request, makeRows()))

    const malformedSnapshots: readonly IntradayMarketSnapshot[] = [
      {
        ...verified,
        quotes: verified.quotes.map((quote, index) => (index === 0 ? { ...quote, eventAt: 'bad' } : quote)),
      },
      {
        ...verified,
        trades: verified.trades.map((trade, index) => (index === 0 ? { ...trade, eventAt: 'bad' } : trade)),
      },
    ]

    for (const malformed of malformedSnapshots) {
      expect(error(reverifyIntradayMarketSnapshot(malformed))).toMatchObject({
        reason: 'rows',
        message: 'intraday quote or trade timestamp does not match the archive contract',
      })
    }
  })

  test('returns a typed row failure for null replayed quote and trade rows', () => {
    const verified = success(verifyIntradaySnapshot(request, makeRows()))

    const malformedSnapshots: readonly IntradayMarketSnapshot[] = [
      {
        ...verified,
        quotes: [null as never, ...verified.quotes.slice(1)],
      },
      {
        ...verified,
        trades: [null as never, ...verified.trades.slice(1)],
      },
    ]

    for (const malformed of malformedSnapshots) {
      expect(error(reverifyIntradayMarketSnapshot(malformed))).toMatchObject({
        reason: 'rows',
        message: 'intraday quote or trade timestamp does not match the archive contract',
      })
    }
  })

  test('returns a typed row failure for malformed replayed snapshot collections', () => {
    const verified = success(verifyIntradaySnapshot(request, makeRows()))

    const malformedSnapshots: readonly IntradayMarketSnapshot[] = [
      { ...verified, bars: null as never },
      { ...verified, quotes: null as never },
      { ...verified, trades: undefined as never },
    ]

    for (const malformed of malformedSnapshots) {
      expect(error(reverifyIntradayMarketSnapshot(malformed))).toMatchObject({
        reason: 'rows',
        message: 'intraday snapshot collections must be arrays',
      })
    }
  })

  test('returns a typed row failure for non-serializable replayed quote and trade payloads', () => {
    const verified = success(verifyIntradaySnapshot(request, makeRows()))

    const malformedSnapshots: readonly IntradayMarketSnapshot[] = [
      {
        ...verified,
        quotes: verified.quotes.map((quote, index) => (index === 0 ? { ...quote, bidPrice: 1n as never } : quote)),
      },
      {
        ...verified,
        trades: verified.trades.map((trade, index) => (index === 0 ? { ...trade, price: 1n as never } : trade)),
      },
    ]

    for (const malformed of malformedSnapshots) {
      expect(error(reverifyIntradayMarketSnapshot(malformed))).toMatchObject({
        reason: 'rows',
        message: 'intraday quote or trade payload does not match the archive contract',
      })
    }
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
          trades: rows.trades.map((trade) => ({
            ...trade,
            event_at: '2026-08-18T13:49:50.000Z',
            ingested_at: '2026-08-18T13:49:50.000Z',
          })),
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
      bars: rows.bars.map((bar) => ({
        ...delayedIdentity(bar),
        ingested_at: new Date(Date.parse(bar.event_at) + 16 * 60_000).toISOString(),
      })),
      quotes: rows.quotes.map((quote) => ({
        ...delayedIdentity(quote),
        ingested_at: '2026-08-18T13:50:15.000Z',
      })),
      trades: rows.trades.map((trade) => ({
        ...delayedIdentity(trade),
        event_at: delayedRequest.rangeEndAt,
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
    expect(
      error(
        verifyIntradaySnapshot(delayedRequest, {
          ...delayedRows,
          bars: delayedRows.bars.map((bar) => ({
            ...bar,
            ingested_at: new Date(Date.parse(bar.event_at) + 60_000).toISOString(),
          })),
        }),
      ),
    ).toMatchObject({
      reason: 'freshness',
      message: 'intraday bar does not match its declared feed delay and finalization window',
    })
  })

  test('allows delayed ingestion after close but rejects post-close market events', () => {
    const rows = makeRows()
    const delayedRequest: IntradaySnapshotRequest = {
      ...request,
      feed: 'delayed_sip',
      delayClass: 'delayed_15m_consolidated',
      rangeStartAt: '2026-08-18T19:55:00.000Z',
      rangeEndAt: '2026-08-18T20:00:00.000Z',
      observedAt: '2026-08-18T20:15:30.000Z',
    }
    const delayedIdentity = <T extends IntradayBarRow | IntradayQuoteRow | IntradayTradeRow>(row: T): T => ({
      ...row,
      feed: delayedRequest.feed,
      delay_class: delayedRequest.delayClass,
    })
    const bars = rows.bars.map((bar) => {
      const eventAt = new Date(Date.parse(bar.event_at) + 6 * 60 * 60_000 + 25 * 60_000).toISOString()
      return {
        ...delayedIdentity(bar),
        event_at: eventAt,
        ingested_at: new Date(Date.parse(eventAt) + 16 * 60_000).toISOString(),
      }
    })
    const quotes = rows.quotes.map((quote) => ({
      ...delayedIdentity(quote),
      event_at: delayedRequest.rangeEndAt,
      ingested_at: '2026-08-18T20:15:00.000Z',
    }))
    const trades = rows.trades.map((trade) => ({
      ...delayedIdentity(trade),
      event_at: delayedRequest.rangeEndAt,
      ingested_at: '2026-08-18T20:15:00.000Z',
    }))

    expect(success(verifyIntradaySnapshot(delayedRequest, { ...rows, bars, quotes, trades })).manifest.observedAt).toBe(
      delayedRequest.observedAt,
    )
    expect(
      error(
        verifyIntradaySnapshot(delayedRequest, {
          ...rows,
          bars,
          quotes: quotes.map((quote) => ({ ...quote, event_at: '2026-08-18T20:00:00.001Z' })),
          trades,
        }),
      ),
    ).toMatchObject({ reason: 'ordering' })
  })
})
