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
  test('renders a real Settings surface without placeholder applications', () => {
    const html = renderToString(
      createElement(ReadyDesktop, {
        agent,
        onChanged: async () => undefined,
        user,
      }),
    )

    expect(html).toContain('aria-label="Dock"')
    expect(html).toContain('Firecracker via kata-fc')
    expect(html).toContain('Sleep Agent')
    expect(html).toContain('Delete Agent')
    expect(html).not.toContain('Open Finder')
    expect(html).not.toContain('Open Chrome')
    expect(html).not.toContain('Open Terminal')
  })
})
