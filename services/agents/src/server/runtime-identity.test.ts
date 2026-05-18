import { describe, expect, it } from 'vitest'

import { isAgentsRuntimeService, resolveRuntimeServiceName } from './runtime-identity'

describe('runtime identity', () => {
  it('uses Agents identity when canonical Agents image env is present', () => {
    expect(resolveRuntimeServiceName({ AGENTS_IMAGE: 'registry.example/lab/agents-controller:abc' })).toBe('agents')
    expect(resolveRuntimeServiceName({ AGENTS_GITOPS_REVISION: 'abc123' })).toBe('agents')
  })

  it('allows explicit compatibility override back to Jangar identity', () => {
    expect(
      isAgentsRuntimeService({
        AGENTS_RUNTIME_SERVICE: 'jangar',
        AGENTS_IMAGE: 'registry.example/lab/agents-controller:abc',
      }),
    ).toBe(false)
  })

  it('keeps Jangar identity when no Agents runtime signal is present', () => {
    expect(resolveRuntimeServiceName({ JANGAR_IMAGE: 'registry.example/lab/jangar:abc' })).toBe('jangar')
  })
})
