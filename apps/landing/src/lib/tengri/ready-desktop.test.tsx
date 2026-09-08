import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { ReadyDesktop } from '@/components/tengri/ready-desktop'
import type { TengriAgent, TengriUser } from './types'

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

describe('Tengri ready desktop', () => {
  test('does not mount usable desktop applications before the browser identity is hydrated', () => {
    const html = renderToString(
      createElement(ReadyDesktop, {
        agent,
        connectionWarning: 'temporary timeout',
        onChanged: async () => undefined,
        previewGatewayOrigin: 'https://tengri.proompteng.ai',
        user,
      }),
    )

    expect(html).toContain('Restoring desktop')
    expect(html).not.toContain('aria-label="Dock"')
    expect(html).not.toContain('Chrome window')
    expect(html).not.toContain('Finder window')
    expect(html).not.toContain('agentrun/')
  })
})
