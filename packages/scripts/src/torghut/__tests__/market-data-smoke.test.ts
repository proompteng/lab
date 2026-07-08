import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'bun:test'

import { evaluateMarketDataSmoke, marketSessionState, selectLatestKafkaRecord } from '../market-data-smoke'

const marketDataSmokeSource = readFileSync(new URL('../market-data-smoke.ts', import.meta.url), 'utf8')

const freshWsReadyz = {
  market_data_channels: [
    {
      channel: 'trades',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
      latest_kafka_success_at_ms: 1783447200000,
      reason: 'market_data_channel_fresh',
    },
    {
      channel: 'quotes',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
      latest_kafka_success_at_ms: 1783447200000,
      reason: 'market_data_channel_fresh',
    },
    {
      channel: 'bars',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
      latest_kafka_success_at_ms: 1783447200000,
      reason: 'market_data_channel_fresh',
    },
    {
      channel: 'updatedBars',
      ready: true,
      subscribed_symbol_count: 10,
      observed_symbol_count: 10,
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

describe('market data smoke freshness evaluation', () => {
  it('identifies regular US equity market session', () => {
    expect(marketSessionState(new Date('2026-07-07T17:00:00Z'))).toBe('regular')
    expect(marketSessionState(new Date('2026-07-07T22:00:00Z'))).toBe('post')
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
    })

    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('accepted_ta_signal_stale')
    expect(result.failures.join('\n')).toContain('kafka_trades_stale')
    expect(result.failures.join('\n')).toContain('ws_trades_missing_kafka_success')
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
    })

    expect(result.sessionState).toBe('post')
    expect(result.enforceFreshness).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.warnings.join('\n')).toContain('accepted_ta_signal_stale')
    expect(result.warnings.join('\n')).toContain('accepted_source_contains_backfill')
    expect(result.warnings.join('\n')).toContain('ta_flink_zero_source_records')
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
    })

    expect(result.sessionState).toBe('regular')
    expect(result.enforceFreshness).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
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
    })

    expect(result.ok).toBe(true)
    expect(result.failures.join('\n')).not.toContain('ta_flink_zero_source_records')
    expect(result.summaryLines.join('\n')).toContain('source_write_records=`15`')
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

  it('does not depend on execing into the distroless websocket container', () => {
    expect(marketDataSmokeSource).not.toContain('TORGHUT_WS_EXEC_TARGET')
    expect(marketDataSmokeSource).not.toContain('fetchJsonViaWsPod')
    expect(marketDataSmokeSource).toContain('const wsReadyz = await fetchJson(settings.wsReadyzUrl)')
    expect(marketDataSmokeSource).toContain('http://torghut-ws.torghut.svc.cluster.local/readyz')
    expect(marketDataSmokeSource).toContain('KAFKA_TOPIC_PARTITIONS')
  })
})
