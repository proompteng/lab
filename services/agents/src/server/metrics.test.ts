import { beforeEach, describe, expect, it, vi } from 'vitest'

const otelMock = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>()
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>()
  const createCounter = vi.fn((name: string) => {
    const counter = { add: vi.fn() }
    counters.set(name, counter)
    return counter
  })
  const createHistogram = vi.fn((name: string) => {
    const histogram = { record: vi.fn() }
    histograms.set(name, histogram)
    return histogram
  })
  const getMeter = vi.fn(() => ({ createCounter, createHistogram }))
  return { counters, histograms, createCounter, createHistogram, getMeter }
})

vi.mock('@proompteng/otel/api', () => ({
  metrics: {
    getMeter: otelMock.getMeter,
  },
}))

import {
  __private,
  configureAgentsMetricsSink,
  recordAgentQueueDepth,
  recordAgentRateLimitRejection,
  recordAgentRunOutcome,
  recordReconcileDurationMs,
  recordSseConnection,
} from './metrics'

describe('agents metrics', () => {
  beforeEach(() => {
    __private.resetForTests()
    otelMock.counters.clear()
    otelMock.histograms.clear()
    otelMock.createCounter.mockClear()
    otelMock.createHistogram.mockClear()
    otelMock.getMeter.mockClear()
  })

  it('records generic Agents metric instruments by default', () => {
    recordAgentRunOutcome('Succeeded', { runtime: 'workflow' })
    recordAgentQueueDepth(3, { scope: 'namespace', namespace: 'agents' })
    recordReconcileDurationMs(42, { kind: 'agentrun' })
    recordSseConnection('control-plane', 'opened')
    recordAgentRateLimitRejection('cluster')

    expect(otelMock.getMeter).toHaveBeenCalledWith('agents')
    expect(otelMock.counters.get('agents_agent_run_outcomes_total')?.add).toHaveBeenCalledWith(1, {
      outcome: 'Succeeded',
      runtime: 'workflow',
    })
    expect(otelMock.histograms.get('agents_queue_depth')?.record).toHaveBeenCalledWith(3, {
      scope: 'namespace',
      namespace: 'agents',
    })
    expect(otelMock.histograms.get('agents_reconcile_duration_ms')?.record).toHaveBeenCalledWith(42, {
      kind: 'agentrun',
    })
    expect(otelMock.counters.get('agents_sse_connections_total')?.add).toHaveBeenCalledWith(1, {
      stream: 'control-plane',
      state: 'opened',
    })
    expect(otelMock.counters.get('agents_rate_limit_rejections_total')?.add).toHaveBeenCalledWith(1, {
      scope: 'cluster',
    })
  })

  it('keeps configured sinks as a compatibility override', () => {
    const recordAgentRunOutcomeOverride = vi.fn()
    configureAgentsMetricsSink({ recordAgentRunOutcome: recordAgentRunOutcomeOverride })

    recordAgentRunOutcome('Failed', { runtime: 'job' })

    expect(recordAgentRunOutcomeOverride).toHaveBeenCalledWith('Failed', { runtime: 'job' })
    expect(otelMock.createCounter).not.toHaveBeenCalled()
  })
})
