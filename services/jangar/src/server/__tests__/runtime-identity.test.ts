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

  it('ignores leaked Agents image metadata', () => {
    expect(
      resolveRuntimeServiceName({
        AGENTS_IMAGE: 'registry.example/lab/agents-control-plane:sha',
      }),
    ).toBe('jangar')
  })

  it('ignores transitional Agents runtime overrides', () => {
    expect(isAgentsRuntimeService({ AGENTS_RUNTIME_SERVICE: 'agents' })).toBe(false)
    expect(resolveRuntimeServiceName({ AGENTS_RUNTIME_SERVICE: '1' })).toBe('jangar')
  })
})
