import { afterEach, describe, expect, it } from 'vitest'

import { resolveSpecPath } from '../agent-runner'

describe('agent-runner spec path resolution', () => {
  const envKeys = ['AGENT_RUNNER_SPEC_PATH', 'AGENT_RUN_SPEC', 'AGENT_SPEC_PATH'] as const

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key]
    }
  })

  it('prefers explicit --spec path over env vars', () => {
    process.env.AGENT_RUNNER_SPEC_PATH = '/workspace/agent-runner.json'
    process.env.AGENT_RUN_SPEC = '/workspace/run.json'

    expect(resolveSpecPath({ specPath: '/tmp/override.json' })).toBe('/tmp/override.json')
  })

  it('prefers AGENT_RUNNER_SPEC_PATH over AGENT_RUN_SPEC', () => {
    process.env.AGENT_RUNNER_SPEC_PATH = '/workspace/agent-runner.json'
    process.env.AGENT_RUN_SPEC = '/workspace/run.json'

    expect(resolveSpecPath({})).toBe('/workspace/agent-runner.json')
  })

  it('falls back to AGENT_RUN_SPEC and AGENT_SPEC_PATH', () => {
    process.env.AGENT_RUN_SPEC = '/workspace/run.json'
    process.env.AGENT_SPEC_PATH = '/workspace/legacy-spec.json'

    expect(resolveSpecPath({})).toBe('/workspace/run.json')

    delete process.env.AGENT_RUN_SPEC
    expect(resolveSpecPath({})).toBe('/workspace/legacy-spec.json')
  })
})
