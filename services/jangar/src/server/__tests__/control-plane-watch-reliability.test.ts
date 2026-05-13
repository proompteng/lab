import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearWatchReliabilityState,
  getWatchReliabilitySummary,
  recordWatchReliabilityError,
  recordWatchReliabilityEvent,
  recordWatchReliabilityRestart,
} from '~/server/control-plane-watch-reliability'

describe('control-plane watch reliability', () => {
  afterEach(() => {
    clearWatchReliabilityState()
    vi.unstubAllEnvs()
  })

  it('keeps a single restart observable without degrading status', () => {
    recordWatchReliabilityEvent({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
    })
    recordWatchReliabilityRestart({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
      reason: 'watch_rate_limited',
    })

    const summary = getWatchReliabilitySummary()

    expect(summary.status).toBe('healthy')
    expect(summary.observed_streams).toBe(1)
    expect(summary.total_restarts).toBe(1)
    expect(summary.total_errors).toBe(0)
    expect(summary.streams[0]?.restart_reasons).toEqual({ watch_rate_limited: 1 })
  })

  it('degrades once restarts cross the configured threshold', () => {
    vi.stubEnv('JANGAR_CONTROL_PLANE_WATCH_HEALTH_RESTART_DEGRADE_THRESHOLD', '2')
    recordWatchReliabilityRestart({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
    })
    recordWatchReliabilityRestart({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
    })

    const summary = getWatchReliabilitySummary()

    expect(summary.status).toBe('degraded')
    expect(summary.total_restarts).toBe(2)
  })

  it('keeps independent single-stream restarts observable without degrading status', () => {
    vi.stubEnv('JANGAR_CONTROL_PLANE_WATCH_HEALTH_RESTART_DEGRADE_THRESHOLD', '2')
    recordWatchReliabilityRestart({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
    })
    recordWatchReliabilityRestart({
      resource: 'agentruns.agents.proompteng.ai',
      namespace: 'agents',
    })
    recordWatchReliabilityRestart({
      resource: 'orchestrations.orchestration.proompteng.ai',
      namespace: 'agents',
    })

    const summary = getWatchReliabilitySummary()

    expect(summary.status).toBe('healthy')
    expect(summary.total_restarts).toBe(3)
    expect(summary.observed_streams).toBe(3)
  })

  it('degrades immediately when watch errors are observed', () => {
    recordWatchReliabilityEvent({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
    })
    recordWatchReliabilityError({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
      reason: 'watch_rate_limited',
    })

    const summary = getWatchReliabilitySummary()

    expect(summary.status).toBe('degraded')
    expect(summary.total_errors).toBe(1)
    expect(summary.streams[0]?.error_reasons).toEqual({ watch_rate_limited: 1 })
  })
})
