import { describe, expect, test } from 'bun:test'

import { createAgentFormSchema } from '@/schemas/tengri-agent'
import { resolveDesktopGate } from './desktop-gate'
import type { AgentPhase, TengriAgent, TengriDesktopSnapshot } from './types'

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
  createdAt: '2026-08-26T00:00:00Z',
  readyAt: '2026-08-26T00:01:00Z',
  lastActivityAt: '2026-08-26T00:01:00Z',
  idleDeadline: '2026-08-26T01:01:00Z',
  expiresAt: '2026-08-26T04:00:00Z',
  conditions: [],
}

const snapshot: TengriDesktopSnapshot = {
  authConfigured: true,
  controlPlaneConfigured: true,
  authenticated: true,
  user: { id: '1', name: 'Greg', email: '', image: null },
  agents: [agent],
}

describe('Tengri desktop lifecycle gate', () => {
  test('prioritizes connectivity, configuration, and identity before agent state', () => {
    expect(resolveDesktopGate(null, '').kind).toBe('loading')
    expect(resolveDesktopGate(null, 'offline').kind).toBe('error')
    expect(resolveDesktopGate({ ...snapshot, authConfigured: false }, '').kind).toBe('auth-unconfigured')
    expect(resolveDesktopGate({ ...snapshot, authenticated: false, user: null }, '').kind).toBe('sign-in')
    expect(resolveDesktopGate({ ...snapshot, controlPlaneConfigured: false }, '').kind).toBe(
      'control-plane-unconfigured',
    )
    expect(resolveDesktopGate({ ...snapshot, agents: [] }, '').kind).toBe('create')
  })

  test('maps every control-plane phase to a truthful lifecycle state', () => {
    const expected: Array<[AgentPhase, ReturnType<typeof resolveDesktopGate>['kind']]> = [
      ['ready', 'ready'],
      ['sleeping', 'sleeping'],
      ['failed', 'failed'],
      ['unknown', 'unknown'],
      ['pending', 'transitioning'],
      ['booting', 'transitioning'],
      ['terminating', 'transitioning'],
    ]
    for (const [phase, kind] of expected) {
      expect(resolveDesktopGate({ ...snapshot, agents: [{ ...agent, phase }] }, '').kind).toBe(kind)
    }
  })

  test('normalizes valid agent names and rejects empty or oversized names', () => {
    expect(createAgentFormSchema.parse({ displayName: '  Tengri  ' })).toEqual({ displayName: 'Tengri' })
    expect(createAgentFormSchema.safeParse({ displayName: '   ' }).success).toBe(false)
    expect(createAgentFormSchema.safeParse({ displayName: 'a'.repeat(65) }).success).toBe(false)
  })
})
