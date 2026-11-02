import { describe, expect, it } from 'vitest'

import { AGENTS_RUNTIME_SERVICE_NAME, resolveRuntimeServiceName } from './runtime-identity'

describe('runtime identity', () => {
  it('uses a fixed Agents identity', () => {
    expect(AGENTS_RUNTIME_SERVICE_NAME).toBe('agents')
    expect(resolveRuntimeServiceName()).toBe('agents')
  })
})
