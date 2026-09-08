import { describe, expect, test } from 'bun:test'

import type { TengriAgent } from '@/lib/tengri/types'

import {
  commitDesktopLifecycleAction,
  formatAgentDate,
  formatAgentResources,
  formatAgentUptime,
  selectSleepRequestError,
  shouldRefreshCodexAccount,
} from './settings-model'

const agent: TengriAgent = {
  id: 'agent-1',
  displayName: 'Tengri',
  phase: 'ready',
  architecture: 'amd64',
  cpuMillis: 2_000,
  memoryMib: 4_096,
  workspaceGib: 16,
  nodeName: 'ryzen',
  message: '',
  createdAt: '2026-08-26T08:00:00.000Z',
  readyAt: '2026-08-26T09:00:00.000Z',
  lastActivityAt: '2026-08-26T10:00:00.000Z',
  idleDeadline: '2026-08-26T11:00:00.000Z',
  expiresAt: '2026-08-26T12:00:00.000Z',
  conditions: [],
}

describe('Tengri Settings model', () => {
  test('gates the guest immediately after a lifecycle request commits', async () => {
    const events: string[] = []

    await commitDesktopLifecycleAction({
      action: 'sleep-agent',
      request: async () => {
        events.push('request')
      },
      onCommitted: (action) => events.push(`committed:${action}`),
    })

    expect(events).toEqual(['request', 'committed:sleep-agent'])
  })

  test('does not gate when the lifecycle request fails', async () => {
    const events: string[] = []
    let failure = ''

    try {
      await commitDesktopLifecycleAction({
        action: 'sleep-agent',
        request: async () => {
          throw new Error('rejected')
        },
        onCommitted: () => events.push('committed'),
      })
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause)
    }

    expect(failure).toBe('rejected')
    expect(events).toEqual([])
  })

  test('refreshes Codex only for a visible active Settings window', () => {
    expect(shouldRefreshCodexAccount({ active: true, documentVisible: true })).toBeTrue()
    expect(shouldRefreshCodexAccount({ active: false, documentVisible: true })).toBeFalse()
    expect(shouldRefreshCodexAccount({ active: true, documentVisible: false })).toBeFalse()
  })

  test('surfaces controller refresh failures while waiting for sleep', () => {
    expect(selectSleepRequestError('', 'Tengri control plane is unavailable')).toBe(
      'Tengri control plane is unavailable',
    )
    expect(selectSleepRequestError('Lifecycle request failed', 'Tengri control plane is unavailable')).toBe(
      'Lifecycle request failed',
    )
  })

  test('defers locale-dependent dates until hydration', () => {
    expect(formatAgentDate(agent.createdAt, false)).toBe('—')
    expect(formatAgentDate(agent.createdAt, true)).not.toBe('—')
    expect(formatAgentDate('not-a-date', true)).toBe('—')
  })

  test('formats runtime resources and ready uptime truthfully', () => {
    expect(formatAgentResources(agent)).toBe('2 CPU · 4 GiB RAM')
    expect(formatAgentUptime(agent, Date.parse('2026-08-26T10:31:00.000Z'))).toBe('1h 31m')
    expect(formatAgentUptime({ ...agent, phase: 'sleeping' }, Date.now())).toBe('—')
    expect(formatAgentUptime(agent, null)).toBe('—')
  })
})
