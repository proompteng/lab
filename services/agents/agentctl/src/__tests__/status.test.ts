import { afterEach, describe, expect, it, vi } from 'vitest'

import { outputStatus } from '../runtime'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agentctl status output', () => {
  it('shows the gRPC address when the status message is empty', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    outputStatus(
      {
        service: 'agents',
        generated_at: '2026-07-16T08:00:00.000Z',
        grpc: {
          enabled: true,
          address: 'agents.example.test:50051',
          status: 'healthy',
          message: '',
        },
      },
      'table',
      'agents',
    )

    expect(log.mock.calls.flat().join('\n')).toContain('agents.example.test:50051')
  })
})
