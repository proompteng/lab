import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

import { evaluateMarketDataSmoke, marketSessionState, selectLatestKafkaRecord } from '../market-data-smoke'
import { decodeTaStatusHeartbeatAvro } from '../ta-status-heartbeat'

const marketDataSmokeSource = readFileSync(new URL('../market-data-smoke.ts', import.meta.url), 'utf8')

const freshWsReadyz = {
  market_data_channels: [
    {
      channel: 'trades',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
      fresh_symbol_count: 10,
      missing_symbols: [],
      stale_symbols: [],
      latest_kafka_success_at_ms: 1783447200000,
      reason: 'market_data_channel_fresh',
    },
    {
      channel: 'quotes',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
      fresh_symbol_count: 10,
      missing_symbols: [],
      stale_symbols: [],
      latest_kafka_success_at_ms: 1783447200000,
      reason: 'market_data_channel_fresh',
    },
    {
      channel: 'bars',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
      fresh_symbol_count: 10,
      missing_symbols: [],
      stale_symbols: [],
      latest_kafka_success_at_ms: 1783447200000,
      reason: 'market_data_channel_fresh',
    },
    {
      channel: 'updatedBars',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
      fresh_symbol_count: 10,
      missing_symbols: [],
      stale_symbols: [],
      latest_kafka_success_at_ms: 1783447200000,
      reason: 'market_data_channel_fresh',
    },
  ],
}

const staleWsReadyz = {
  market_data_channels: [
    {
      channel: 'trades',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 0,
      latest_kafka_success_at_ms: null,
      reason: 'market_data_channel_gate_inactive',
    },
    {
      channel: 'quotes',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 0,
      latest_kafka_success_at_ms: null,
      reason: 'market_data_channel_gate_inactive',
    },
    {
      channel: 'bars',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 0,
      latest_kafka_success_at_ms: null,
      reason: 'market_data_channel_gate_inactive',
    },
    {
      channel: 'updatedBars',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 0,
      latest_kafka_success_at_ms: null,
      reason: 'market_data_channel_gate_inactive',
    },
  ],
}

const conditionalUpdatedBarsNoEventsReadyz = {
  market_data_channels: freshWsReadyz.market_data_channels.map((channel) =>
    channel.channel === 'updatedBars'
      ? {
          ...channel,
          observed_symbol_count: 0,
          fresh_symbol_count: 0,
          latest_kafka_success_at_ms: null,
          reason: 'market_data_channel_conditional_no_events',
        }
      : channel,
  ),
}

const updatedBarsObservedWithoutKafkaReadyz = {
  market_data_channels: freshWsReadyz.market_data_channels.map((channel) =>
    channel.channel === 'updatedBars'
      ? {
          ...channel,
          ready: false,
          observed_symbol_count: 1,
          fresh_symbol_count: 0,
          latest_kafka_success_at_ms: null,
          reason: 'market_data_channel_conditional_missing_kafka_success',
        }
      : channel,
  ),
}

const partialCoverageWsReadyz = {
  market_data_channels: freshWsReadyz.market_data_channels.map((channel) =>
    channel.channel === 'trades'
      ? {
          ...channel,
          fresh_symbol_count: 9,
          missing_symbols: ['AMD'],
          reason: 'market_data_channel_missing_symbol_coverage',
        }
      : channel,
  ),
}

const tradingStatusWithFreshAcceptedTa = {
  live_submission_gate: {
    clickhouse_ta_freshness: {
      accepted_sources: ['ta'],
      latest_accepted_event_at: '2026-07-07T17:00:00Z',
      accepted_lag_seconds: 0,
      accepted_max_lag_seconds: 300,
      accepted_source_state: 'fresh',
      blocking_reason: null,
    },
  },
}

const tradingStatusWithStaleAcceptedTa = {
  live_submission_gate: {
    clickhouse_ta_freshness: {
      accepted_sources: ['ta'],
      latest_accepted_event_at: '2026-06-30T20:59:27Z',
      accepted_lag_seconds: 604000,
      accepted_max_lag_seconds: 300,
      accepted_source_state: 'stale',
      blocking_reason: 'accepted_ta_signal_stale',
      excluded_fresher_sources: [{ source: 'rest', excluded_reason: 'source_not_allowed_for_live_runtime' }],
    },
  },
}

const tradingStatusWithRestAcceptedBackfill = {
  live_submission_gate: {
    clickhouse_ta_freshness: {
      ...tradingStatusWithStaleAcceptedTa.live_submission_gate.clickhouse_ta_freshness,
      accepted_sources: ['rest', 'ta'],
    },
  },
}

const liveTaRuntimeConfig = {
  groupId: 'torghut-ta-live',
  autoOffsetReset: 'latest',
}

const freshTaStatusHeartbeat = {
  topic: 'torghut.ta.status.v1',
  partition: 0,
  ingestTs: '2026-07-07T17:00:20Z',
  eventTs: '2026-07-07T17:00:20Z',
  symbol: 'ta',
  seq: 10,
  isFinal: true,
  source: 'ta',
  watermarkLagMs: 5_000,
  sourceLagMs: 20_000,
  lastEventTs: '2026-07-07T17:00:00Z',
  lastInputEventTs: '2026-07-07T17:00:00Z',
  lastOutputEventTs: '2026-07-07T17:00:00Z',
  inputEventCount: 240,
  outputEventCount: 120,
  currentInputEventCount: 20,
  currentOutputEventCount: 10,
  currentRecordCount: 30,
  inputRatePerSecond: 2,
  outputRatePerSecond: 1,
  microbarEventCount: 240,
  signalEventCount: 120,
  microbarRatePerSecond: 2,
  signalRatePerSecond: 1,
  clickhouseSinkEnabled: true,
  perSymbolLatestEventTs: {
    NVDA: '2026-07-07T17:00:00Z',
    AMD: '2026-07-07T17:00:00Z',
  },
  marketSessionState: 'regular',
  status: 'ok',
  heartbeat: true,
  version: 1,
}

const staleTaStatusHeartbeat = {
  ...freshTaStatusHeartbeat,
  ingestTs: '2026-07-07T17:00:20Z',
  eventTs: '2026-07-07T17:00:20Z',
  sourceLagMs: 610_000,
  lastEventTs: '2026-07-07T16:50:00Z',
  lastInputEventTs: '2026-07-07T16:50:00Z',
  lastOutputEventTs: '2026-07-07T16:50:00Z',
  currentInputEventCount: 0,
  currentOutputEventCount: 0,
  currentRecordCount: 0,
  inputRatePerSecond: 0,
  outputRatePerSecond: 0,
  microbarRatePerSecond: 0,
  signalRatePerSecond: 0,
  statusReason: 'zero_current_records_during_regular_session',
  status: 'degraded',
}

const freshTaFlinkJob = {
  jid: 'job-live',
  state: 'RUNNING',
  vertices: [
    {
      name: 'Source: ta-trades-source -> Flat Map -> Timestamps/Watermarks',
      status: 'RUNNING',
      metrics: { 'read-records': 120, 'write-records': 120 },
    },
    {
      name: 'Source: ta-quotes-source -> Flat Map -> Timestamps/Watermarks',
      status: 'RUNNING',
      metrics: { 'read-records': 120, 'write-records': 120 },
    },
    {
      name: 'Source: ta-bars1m-source -> Flat Map -> Timestamps/Watermarks',
      status: 'RUNNING',
      metrics: { 'read-records': 10, 'write-records': 10 },
    },
    {
      name: 'ta-microbars -> sink-microbars: Writer -> sink-microbars: Committer',
      status: 'RUNNING',
      metrics: { 'read-records': 120, 'write-records': 120 },
    },
    {
      name: 'ta-signals -> sink-signals: Writer -> sink-signals: Committer',
      status: 'RUNNING',
      metrics: { 'read-records': 120, 'write-records': 120 },
    },
    {
      name: 'ta-status -> sink-status: Writer -> sink-status: Committer',
      status: 'RUNNING',
      metrics: { 'read-records': 4, 'write-records': 4 },
    },
    {
      name: 'sink-signals-clickhouse: Writer -> sink-signals-clickhouse: Committer',
      status: 'RUNNING',
      metrics: { 'read-records': 120, 'write-records': 120 },
    },
    {
      name: 'sink-microbars-clickhouse: Writer -> sink-microbars-clickhouse: Committer',
      status: 'RUNNING',
      metrics: { 'read-records': 120, 'write-records': 120 },
    },
  ],
}

const zeroCurrentTaFlinkJob = {
  ...freshTaFlinkJob,
  vertices: freshTaFlinkJob.vertices.map((vertex) => ({
    ...vertex,
    metrics: { 'read-records': 0, 'write-records': 0 },
  })),
}

const stalledRateTaFlinkJob = {
  ...freshTaFlinkJob,
  vertices: freshTaFlinkJob.vertices.map((vertex) => ({
    ...vertex,
    metrics: {
      ...vertex.metrics,
      'records-in-per-second': 0,
      'records-out-per-second': 0,
    },
  })),
}

const testTextEncoder = new TextEncoder()

const concatBytes = (chunks: Uint8Array[]): Buffer => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))

const encodeLong = (value: number): Buffer => {
  let raw = BigInt(value)
  raw = (raw << 1n) ^ (raw >> 63n)
  const out: number[] = []
  while ((raw & ~0x7fn) !== 0n) {
    out.push(Number((raw & 0x7fn) | 0x80n))
    raw >>= 7n
  }
  out.push(Number(raw))
  return Buffer.from(out)
}

const encodeString = (value: string): Buffer => {
  const bytes = testTextEncoder.encode(value)
  return concatBytes([encodeLong(bytes.length), bytes])
}

const encodeDouble = (value: number): Buffer => {
  const buffer = Buffer.alloc(8)
  buffer.writeDoubleLE(value)
  return buffer
}

const encodeBoolean = (value: boolean): Buffer => Buffer.from([value ? 1 : 0])

const encodeNullableLong = (value: number | undefined): Buffer =>
  value === undefined ? encodeLong(0) : concatBytes([encodeLong(1), encodeLong(value)])

const encodeNullableDouble = (value: number | undefined): Buffer =>
  value === undefined ? encodeLong(0) : concatBytes([encodeLong(1), encodeDouble(value)])

const encodeNullableString = (value: string | undefined): Buffer =>
  value === undefined ? encodeLong(0) : concatBytes([encodeLong(1), encodeString(value)])

const encodeNullableBoolean = (value: boolean | undefined): Buffer =>
  value === undefined ? encodeLong(0) : concatBytes([encodeLong(1), encodeBoolean(value)])

const encodeNullableStringMap = (value: Record<string, string> | undefined): Buffer => {
  if (value === undefined) return encodeLong(0)
  const entries = Object.entries(value)
  return concatBytes([
    encodeLong(1),
    encodeLong(entries.length),
    ...entries.flatMap(([key, item]) => [encodeString(key), encodeString(item)]),
    encodeLong(0),
  ])
}

const encodeNullableVersion = (value: number | undefined): Buffer =>
  value === undefined ? encodeLong(1) : concatBytes([encodeLong(0), encodeLong(value)])

const encodeTaStatusFixture = (heartbeat: typeof freshTaStatusHeartbeat & { statusReason?: string }): Buffer =>
  concatBytes([
    encodeString(heartbeat.ingestTs),
    encodeString(heartbeat.eventTs),
    encodeString(heartbeat.symbol),
    encodeLong(heartbeat.seq),
    encodeNullableBoolean(heartbeat.isFinal),
    encodeNullableString(heartbeat.source),
    encodeLong(0),
    encodeNullableLong(heartbeat.watermarkLagMs),
    encodeNullableLong(heartbeat.sourceLagMs),
    encodeNullableString(heartbeat.lastEventTs),
    encodeNullableString(heartbeat.lastInputEventTs),
    encodeNullableString(heartbeat.lastOutputEventTs),
    encodeNullableLong(heartbeat.inputEventCount),
    encodeNullableLong(heartbeat.outputEventCount),
    encodeNullableLong(heartbeat.currentInputEventCount),
    encodeNullableLong(heartbeat.currentOutputEventCount),
    encodeNullableLong(heartbeat.currentRecordCount),
    encodeNullableDouble(heartbeat.inputRatePerSecond),
    encodeNullableDouble(heartbeat.outputRatePerSecond),
    encodeNullableLong(heartbeat.microbarEventCount),
    encodeNullableLong(heartbeat.signalEventCount),
    encodeNullableDouble(heartbeat.microbarRatePerSecond),
    encodeNullableDouble(heartbeat.signalRatePerSecond),
    encodeNullableBoolean(heartbeat.clickhouseSinkEnabled),
    encodeNullableStringMap(heartbeat.perSymbolLatestEventTs),
    encodeNullableString(heartbeat.marketSessionState),
    encodeNullableString(heartbeat.statusReason),
    encodeString(heartbeat.status),
    encodeNullableBoolean(heartbeat.heartbeat),
    encodeNullableVersion(heartbeat.version),
  ])

describe('market data smoke freshness evaluation', () => {
  it('decodes TA status heartbeat Avro evidence from Kafka bytes', () => {
    const encoded = encodeTaStatusFixture(freshTaStatusHeartbeat)
    const decoded = decodeTaStatusHeartbeatAvro(encoded, {
      topic: 'torghut.ta.status.v1',
      partition: 2,
    })
    const prefixed = decodeTaStatusHeartbeatAvro(concatBytes([Buffer.from([0, 0, 0, 0, 7]), encoded]), {
      topic: 'torghut.ta.status.v1',
      partition: 2,
    })

    expect(decoded).toMatchObject({
      topic: 'torghut.ta.status.v1',
      partition: 2,
      eventTs: '2026-07-07T17:00:20Z',
      symbol: 'ta',
      seq: 10,
      sourceLagMs: 20_000,
      currentRecordCount: 30,
      currentInputEventCount: 20,
      currentOutputEventCount: 10,
      clickhouseSinkEnabled: true,
      marketSessionState: 'regular',
      status: 'ok',
      heartbeat: true,
      version: 1,
    })
    expect(prefixed).toMatchObject({
      topic: 'torghut.ta.status.v1',
      partition: 2,
      eventTs: '2026-07-07T17:00:20Z',
      status: 'ok',
      version: 1,
    })
    expect(decoded.perSymbolLatestEventTs).toEqual({
      NVDA: '2026-07-07T17:00:00Z',
      AMD: '2026-07-07T17:00:00Z',
    })
  })

  it('identifies regular US equity market session', () => {
    expect(marketSessionState(new Date('2026-07-07T17:00:00Z'))).toBe('regular')
    expect(marketSessionState(new Date('2026-07-07T22:00:00Z'))).toBe('post')
  })

  it('does not enforce regular-session freshness on configured market holidays', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-03T17:00:00Z'),
      mode: 'auto',
      holidays: new Set(['2026-07-03']),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-02T20:54:58Z', symbol: 'SNDK' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-02T20:33:55Z', symbol: 'SNDK' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-02T20:59:00Z', symbol: 'NVDA' },
      },
      wsReadyz: staleWsReadyz,
      tradingStatus: tradingStatusWithStaleAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: zeroCurrentTaFlinkJob,
      taStatusHeartbeat: staleTaStatusHeartbeat,
    })

    expect(result.sessionState).toBe('holiday')
    expect(result.enforceFreshness).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.warnings.join('\n')).toContain('accepted_ta_signal_stale')
    expect(result.warnings.join('\n')).toContain('ta_flink_zero_source_records')
  })

  it('ships 2026 US equity holidays as the smoke default calendar', () => {
    expect(marketDataSmokeSource).toContain('DEFAULT_US_EQUITY_MARKET_HOLIDAYS')
    expect(marketDataSmokeSource).toContain("'2026-07-03'")
    expect(marketDataSmokeSource).toContain(
      'holidays: new Set(parseList(process.env.MARKET_DATA_HOLIDAYS, DEFAULT_US_EQUITY_MARKET_HOLIDAYS))',
    )
  })

  it('fails in auto mode during regular market hours when accepted TA and source topics are stale', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:00Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-06-30T20:54:58Z', symbol: 'SNDK' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-06-30T20:33:55Z', symbol: 'SNDK' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T16:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: staleWsReadyz,
      tradingStatus: tradingStatusWithStaleAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: zeroCurrentTaFlinkJob,
      taStatusHeartbeat: staleTaStatusHeartbeat,
    })

    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('accepted_ta_signal_stale')
    expect(result.failures.join('\n')).toContain('kafka_trades_stale')
    expect(result.failures.join('\n')).toContain('ws_trades_missing_kafka_success')
    expect(result.failures.join('\n')).toContain('ta_status_degraded')
    expect(result.failures.join('\n')).toContain('ta_status_source_lag_stale')
  })

  it('observes the same stale data after hours without claiming market-session proof', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T22:00:00Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-06-30T20:54:58Z', symbol: 'SNDK' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-06-30T20:33:55Z', symbol: 'SNDK' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T19:59:00Z', symbol: 'NVDA' },
      },
      wsReadyz: staleWsReadyz,
      tradingStatus: tradingStatusWithRestAcceptedBackfill,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: zeroCurrentTaFlinkJob,
      taStatusHeartbeat: staleTaStatusHeartbeat,
    })

    expect(result.sessionState).toBe('post')
    expect(result.enforceFreshness).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.warnings.join('\n')).toContain('accepted_ta_signal_stale')
    expect(result.warnings.join('\n')).toContain('accepted_source_contains_backfill')
    expect(result.warnings.join('\n')).toContain('ta_flink_zero_source_records')
    expect(result.warnings.join('\n')).toContain('ta_status_degraded')
  })

  it('passes during regular market hours when WS topics and accepted TA are fresh', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: freshTaFlinkJob,
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.sessionState).toBe('regular')
    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('passes during regular market hours when updatedBars has conditional no-events readiness', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: conditionalUpdatedBarsNoEventsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: freshTaFlinkJob,
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.failures.join('\n')).not.toContain('ws_updatedBars_symbol_coverage_gap')
    expect(result.failures.join('\n')).not.toContain('ws_updatedBars_missing_kafka_success')
  })

  it('fails during regular market hours when observed updatedBars corrections do not reach Kafka', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: updatedBarsObservedWithoutKafkaReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: freshTaFlinkJob,
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ws_updatedBars_not_ready')
    expect(result.failures.join('\n')).toContain('ws_updatedBars_symbol_coverage_gap')
    expect(result.failures.join('\n')).toContain('ws_updatedBars_missing_kafka_success')
  })

  it('fails during regular market hours when WS symbol coverage is incomplete', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: partialCoverageWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: freshTaFlinkJob,
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ws_trades_symbol_coverage_gap')
    expect(result.summaryLines.join('\n')).toContain('missing=`AMD`')
  })

  it('fails during regular market hours when TA status heartbeat is missing', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: freshTaFlinkJob,
    })

    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ta_status_heartbeat_missing')
  })

  it('fails even after hours when production TA is left in replay mode', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T22:00:00Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T21:59:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T21:59:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T21:59:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: {
        groupId: 'torghut-ta-replay-profit-proof-signal-gap-20260601T0437Z',
        autoOffsetReset: 'earliest',
      },
      taFlinkJob: freshTaFlinkJob,
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.enforceFreshness).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ta_replay_group_enabled')
    expect(result.failures.join('\n')).toContain('ta_auto_offset_reset_not_latest')
  })

  it('fails during regular market hours when Flink is running but has zero current records', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: zeroCurrentTaFlinkJob,
      taStatusHeartbeat: staleTaStatusHeartbeat,
    })

    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ta_flink_zero_source_records')
    expect(result.failures.join('\n')).toContain('ta_flink_zero_signal_records')
    expect(result.summaryLines.join('\n')).toContain('source_write_records=`0`')
  })

  it('uses Flink source output counters when current-rate metrics are missing', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: {
        ...freshTaFlinkJob,
        vertices: freshTaFlinkJob.vertices.map((vertex) =>
          vertex.name.startsWith('Source: ta-')
            ? {
                ...vertex,
                metrics: { 'read-records': 0, 'write-records': 5 },
              }
            : vertex,
        ),
      },
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.ok).toBe(true)
    expect(result.failures.join('\n')).not.toContain('ta_flink_zero_source_records')
    expect(result.summaryLines.join('\n')).toContain('source_write_records=`15`')
  })

  it('allows the bounded startup heartbeat source to stay finished after savepoint restore', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: {
        ...freshTaFlinkJob,
        vertices: [
          ...freshTaFlinkJob.vertices,
          {
            name: 'Source: Collection Source',
            status: 'FINISHED',
            metrics: { 'read-records': 0, 'write-records': 0 },
          },
        ],
      },
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.ok).toBe(true)
    expect(result.failures.join('\n')).not.toContain('ta_flink_vertices_not_running')
  })

  it('still fails unexpected finished Flink vertices', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: {
        ...freshTaFlinkJob,
        vertices: freshTaFlinkJob.vertices.map((vertex) =>
          vertex.name.startsWith('Source: ta-trades-source') ? { ...vertex, status: 'FINISHED' } : vertex,
        ),
      },
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ta_flink_vertices_not_running')
  })

  it('uses Flink current-rate metrics over lifetime counters when detecting current stalls', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T17:00:30Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: stalledRateTaFlinkJob,
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ta_flink_zero_source_records')
    expect(result.summaryLines.join('\n')).toContain('source_records_per_second=`0`')
  })

  it('fails regardless of market session when the Flink job is not running', () => {
    const result = evaluateMarketDataSmoke({
      now: new Date('2026-07-07T22:00:00Z'),
      mode: 'auto',
      holidays: new Set(),
      maxKafkaLagSeconds: 300,
      acceptedMaxLagSeconds: 300,
      latestKafkaByRole: {
        trades: { topic: 'torghut.trades.v1', eventTs: '2026-07-07T21:59:00Z', symbol: 'NVDA' },
        quotes: { topic: 'torghut.quotes.v1', eventTs: '2026-07-07T21:59:00Z', symbol: 'NVDA' },
        bars: { topic: 'torghut.bars.1m.v1', eventTs: '2026-07-07T21:59:00Z', symbol: 'NVDA' },
      },
      wsReadyz: freshWsReadyz,
      tradingStatus: tradingStatusWithFreshAcceptedTa,
      taRuntimeConfig: liveTaRuntimeConfig,
      taFlinkJob: {
        ...freshTaFlinkJob,
        state: 'FAILED',
      },
      taStatusHeartbeat: freshTaStatusHeartbeat,
    })

    expect(result.enforceFreshness).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ta_flink_not_running')
  })

  it('selects the freshest Kafka record across sampled partitions', () => {
    expect(
      selectLatestKafkaRecord([
        { topic: 'torghut.trades.v1', partition: 0, eventTs: '2026-07-07T17:00:00Z', symbol: 'NVDA' },
        { topic: 'torghut.trades.v1', partition: 1, eventTs: '2026-07-07T17:00:10Z', symbol: 'AMD' },
        { topic: 'torghut.trades.v1', partition: 2, eventTs: 'invalid', symbol: 'AVGO' },
      ]),
    ).toMatchObject({
      partition: 1,
      eventTs: '2026-07-07T17:00:10Z',
      symbol: 'AMD',
    })
  })

  it('uses a non-WS pod proxy for in-cluster HTTP probes by default', () => {
    expect(marketDataSmokeSource).not.toContain('TORGHUT_WS_EXEC_TARGET')
    expect(marketDataSmokeSource).not.toContain('fetchJsonViaWsPod')
    expect(marketDataSmokeSource).toContain('TORGHUT_MARKET_DATA_HTTP_MODE')
    expect(marketDataSmokeSource).toContain('parseHttpProbeMode(process.env.TORGHUT_MARKET_DATA_HTTP_MODE)')
    expect(marketDataSmokeSource).toContain(
      "httpExecTarget: process.env.TORGHUT_MARKET_DATA_HTTP_EXEC_TARGET ?? 'deploy/torghut-ta'",
    )
    expect(marketDataSmokeSource).toContain('const wsReadyz = await fetchRuntimeJson(settings.wsReadyzUrl, settings)')
    expect(marketDataSmokeSource).toContain('http://torghut-ws.torghut.svc.cluster.local/readyz')
    expect(marketDataSmokeSource).toContain('KAFKA_TOPIC_PARTITIONS')
    expect(marketDataSmokeSource).toContain("raw.trim().toLowerCase() === 'auto'")
    expect(marketDataSmokeSource).toContain("tailArgs(topic, 'partitions', settings, 0, '1')")
  })
})
