import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import type { TengriAgent, TengriUser } from '@/lib/tengri/types'

import { SettingsApp } from './settings-app'

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
  createdAt: '2026-08-27T12:00:00Z',
  readyAt: '2026-08-27T12:01:00Z',
  lastActivityAt: '2026-08-27T12:02:00Z',
  idleDeadline: '2026-08-27T13:02:00Z',
  expiresAt: '2026-08-27T16:00:00Z',
  conditions: [],
}

const user: TengriUser = {
  id: 'github:42',
  name: 'Tengri User',
  email: 'tengri@example.com',
  image: null,
}

describe('Tengri Settings', () => {
  test('server-renders truthful runtime data with hydration-stable date placeholders', () => {
    const html = renderToString(
      createElement(SettingsApp, {
        active: false,
        agent,
        busyAction: null,
        error: '',
        instanceId: 'settings-1',
        lifecycleDisabled: false,
        onDelete: () => undefined,
        onSignOut: () => undefined,
        onSleep: () => undefined,
        user,
      }),
    )

    expect(html).toContain('Kata Firecracker (kata-fc)')
    expect(html).toContain('2 CPU · 4 GiB RAM')
    expect(html).toContain('Checking login…')
    expect(html).toContain('Sleep Agent')
    expect(html).not.toContain('2026-08-27')
  })
})
