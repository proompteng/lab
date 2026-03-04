import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearWatchReliabilityState,
  getWatchReliabilitySummary,
  recordWatchReliabilityError,
  recordWatchReliabilityEvent,
  recordWatchReliabilityRestart,
} from '~/server/control-plane-watch-reliability'

const withEnv = <T>(updates: Record<string, string | undefined>, fn: () => T): T => {
  const backup = { ...process.env }
  Object.entries(updates).forEach(([key, value]) => {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  })
  try {
    return fn()
  } finally {
    process.env = backup
  }
}

describe('control-plane watch reliability', () => {
  beforeEach(() => {
    clearWatchReliabilityState()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns degraded state when errors occur in the configured window', () => {
    recordWatchReliabilityEvent({ resource: 'AgentRun', namespace: 'agents' })
    recordWatchReliabilityEvent({ resource: 'AgentRun', namespace: 'agents' })
    recordWatchReliabilityError({ resource: 'Agent', namespace: 'agents' })

    const summary = getWatchReliabilitySummary()
    expect(summary.status).toBe('degraded')
    expect(summary.total_events).toBe(2)
    expect(summary.total_errors).toBe(1)
    expect(summary.total_restarts).toBe(0)
    expect(summary.streams).toHaveLength(2)
    expect(summary.streams[0]).toMatchObject({ resource: 'Agent', namespace: 'agents', errors: 1, events: 0 })
    expect(summary.streams[1]).toMatchObject({ resource: 'AgentRun', namespace: 'agents', events: 2, errors: 0 })
  })

  it('returns unknown when no stream activity exists in the window', () => {
    const summary = getWatchReliabilitySummary()
    expect(summary.status).toBe('unknown')
    expect(summary.total_events).toBe(0)
    expect(summary.total_errors).toBe(0)
    expect(summary.total_restarts).toBe(0)
    expect(summary.streams).toHaveLength(0)
  })

  it('expires observations outside the configured window', () => {
    withEnv({ JANGAR_CONTROL_PLANE_WATCH_HEALTH_WINDOW_MINUTES: '5' }, () => {
      recordWatchReliabilityError({ resource: 'Agent', namespace: 'agents' })
      vi.advanceTimersByTime(6 * 60 * 1000)
      const summary = getWatchReliabilitySummary()
      expect(summary.status).toBe('unknown')
      expect(summary.total_errors).toBe(0)
      expect(summary.streams).toHaveLength(0)
    })
  })

  it('includes restarts in status and degraded detection', () => {
    recordWatchReliabilityRestart({ resource: 'Workflow', namespace: 'agents' })
    const summary = getWatchReliabilitySummary()
    expect(summary.status).toBe('degraded')
    expect(summary.total_restarts).toBe(1)
    expect(summary.streams[0]).toMatchObject({ resource: 'Workflow', namespace: 'agents', restarts: 1 })
  })
})
