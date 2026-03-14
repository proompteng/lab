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
    })

    const summary = getWatchReliabilitySummary()

    expect(summary.status).toBe('healthy')
    expect(summary.observed_streams).toBe(1)
    expect(summary.total_restarts).toBe(1)
    expect(summary.total_errors).toBe(0)
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

  it('degrades immediately when watch errors are observed', () => {
    recordWatchReliabilityEvent({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
    })
    recordWatchReliabilityError({
      resource: 'toolruns.tools.proompteng.ai',
      namespace: 'agents',
    })

    const summary = getWatchReliabilitySummary()

    expect(summary.status).toBe('degraded')
    expect(summary.total_errors).toBe(1)
  })
})
