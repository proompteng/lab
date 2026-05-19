import { describe, expect, it } from 'vitest'

import { isAgentsRuntimeService, resolveRuntimeServiceName } from '../runtime-identity'

describe('Jangar runtime identity', () => {
  it('defaults to Jangar for Jangar image metadata', () => {
    expect(
      resolveRuntimeServiceName({
        JANGAR_IMAGE: 'registry.example/lab/jangar:sha',
      }),
    ).toBe('jangar')
  })

  it('uses Agents identity when explicit Agents image metadata is present', () => {
    expect(
      resolveRuntimeServiceName({
        AGENTS_IMAGE: 'registry.example/lab/agents-control-plane:sha',
      }),
    ).toBe('agents')
  })

  it('allows an explicit Agents runtime override for transitional callers', () => {
    expect(isAgentsRuntimeService({ AGENTS_RUNTIME_SERVICE: 'agents' })).toBe(true)
    expect(resolveRuntimeServiceName({ AGENTS_RUNTIME_SERVICE: '1' })).toBe('agents')
  })
})
