import { describe, expect, it } from 'bun:test'

import { evaluateMarketDataSmoke, marketSessionState } from '../market-data-smoke'

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
    })

    expect(result.sessionState).toBe('post')
    expect(result.enforceFreshness).toBe(false)
    expect(result.ok).toBe(true)
    expect(result.warnings.join('\n')).toContain('accepted_ta_signal_stale')
    expect(result.warnings.join('\n')).toContain('accepted_source_contains_backfill')
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
    })

    expect(result.enforceFreshness).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.failures.join('\n')).toContain('ta_replay_group_enabled')
    expect(result.failures.join('\n')).toContain('ta_auto_offset_reset_not_latest')
  })
})
