import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import YAML from 'yaml'
import { REQUIRED_CRDS } from '../kube/fleet'

import { outputStatus } from '../runtime'

afterEach(() => {
  mock.restore()
})

describe('agentctl status output', () => {
  it('checks exactly the 20 CRDs shipped by the Agents chart', () => {
    const directory = new URL('../../../../../charts/agents/crds/', import.meta.url)
    const names = readdirSync(directory)
      .filter((file) => file.endsWith('.yaml'))
      .map((file) => YAML.parse(readFileSync(new URL(file, directory), 'utf8')).metadata.name)
    expect(REQUIRED_CRDS).toHaveLength(20)
    expect([...REQUIRED_CRDS].sort()).toEqual(names.sort())
  })

  it('shows the gRPC address when the status message is empty', () => {
    const log = spyOn(console, 'log').mockImplementation(() => {})

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
