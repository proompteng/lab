import { describe, expect, test } from 'bun:test'
import type { AgentPhase, TengriAgent, TengriDesktopSnapshot } from '@/lib/tengri/types'
import { resolveDesktopGate } from './desktop-gates'

const agent: TengriAgent = {
  id: 'agent-one',
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
  user: { id: 'github:1', name: 'Greg', email: '', image: null },
  agents: [agent],
}

describe('Tengri desktop lifecycle gates', () => {
  test('keeps configuration and identity failures ahead of agent state', () => {
    expect(resolveDesktopGate(null, null, '').kind).toBe('loading')
    expect(resolveDesktopGate(null, null, 'offline').kind).toBe('error')
    expect(resolveDesktopGate({ ...snapshot, authConfigured: false }, agent, '').kind).toBe('auth-unconfigured')
    expect(resolveDesktopGate({ ...snapshot, authenticated: false, user: null }, agent, '').kind).toBe('sign-in')
    expect(resolveDesktopGate({ ...snapshot, controlPlaneConfigured: false }, agent, '').kind).toBe(
      'control-plane-unconfigured',
    )
    expect(resolveDesktopGate({ ...snapshot, agents: [] }, null, '').kind).toBe('create')
  })

  test('maps every control-plane phase to a truthful desktop state', () => {
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
      expect(resolveDesktopGate(snapshot, { ...agent, phase }, '').kind).toBe(kind)
    }
  })
})
