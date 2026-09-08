import { Effect } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearWatchReliabilityState,
  createControlPlaneWatchReliabilityService,
  getWatchReliabilitySummary,
  recordWatchReliabilityError,
  recordWatchReliabilityEvent,
  recordWatchReliabilityRestart,
  resolveControlPlaneWatchReliabilityConfig,
} from './control-plane-watch-reliability'

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

  it('degrades once restarts cross the configured Agents threshold', () => {
    vi.stubEnv('AGENTS_CONTROL_PLANE_WATCH_HEALTH_RESTART_DEGRADE_THRESHOLD', '2')
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
    vi.stubEnv('AGENTS_CONTROL_PLANE_WATCH_HEALTH_RESTART_DEGRADE_THRESHOLD', '2')
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

  it('exposes an injectable Effect service with an isolated store and clock', async () => {
    const store = new Map()
    const service = createControlPlaneWatchReliabilityService({
      store,
      now: () => new Date('2026-05-20T12:00:00.000Z'),
      env: { AGENTS_CONTROL_PLANE_WATCH_HEALTH_WINDOW_MINUTES: '15' },
    })

    await Effect.runPromise(
      service.recordEvent({
        resource: 'agentruns.agents.proompteng.ai',
        namespace: 'agents',
      }),
    )
    const summary = await Effect.runPromise(service.summarize())

    expect(summary).toMatchObject({
      status: 'healthy',
      window_minutes: 15,
      observed_streams: 1,
      total_events: 1,
      streams: [
        expect.objectContaining({
          resource: 'agentruns.agents.proompteng.ai',
          namespace: 'agents',
          last_seen_at: '2026-05-20T12:00:00.000Z',
        }),
      ],
    })
  })
})
