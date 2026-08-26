import { describe, expect, test } from 'bun:test'

import type { TengriAgent } from '@/lib/tengri/types'

import {
  formatAgentDate,
  formatAgentPhase,
  formatAgentResources,
  formatAgentUptime,
  lifecycleActionForPhase,
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
  test('offers lifecycle actions only in actionable phases', () => {
    expect(lifecycleActionForPhase('ready')).toBe('sleep-agent')
    expect(lifecycleActionForPhase('sleeping')).toBe('resume-agent')
    expect(lifecycleActionForPhase('booting')).toBeNull()
    expect(lifecycleActionForPhase('terminating')).toBeNull()
    expect(lifecycleActionForPhase('failed')).toBeNull()
  })

  test('formats truthful phase and resource values', () => {
    expect(formatAgentPhase('ready')).toBe('Ready')
    expect(formatAgentPhase('unknown')).toBe('Unknown')
    expect(formatAgentResources(agent)).toBe('2 CPU · 4 GiB RAM')
  })

  test('reports uptime only while the agent is ready', () => {
    expect(formatAgentUptime(agent, Date.parse('2026-08-26T10:31:00.000Z'))).toBe('1h 31m')
    expect(formatAgentUptime({ ...agent, phase: 'sleeping' }, Date.parse('2026-08-26T10:31:00.000Z'))).toBe('—')
  })

  test('does not invent dates when the control plane omits or corrupts them', () => {
    expect(formatAgentDate('')).toBe('—')
    expect(formatAgentDate('not-a-date')).toBe('—')
  })
})
